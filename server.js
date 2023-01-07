const request = require('request');
const express = require('express');
const sqlite3 = require('sqlite3');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

let isCFdown = false;

// Initiating DB(SQLITE)
const db = new sqlite3.Database('./cf-upsolve.db', sqlite3.OPEN_CREATE | sqlite3.OPEN_READWRITE, (error) => {
  if (error) {
    console.error(error.message);
    process.exit(1);
  } else {
    console.log('db connected successfully');
  }
});

// Create tables
db.run('CREATE TABLE IF NOT EXISTS user(cf_handle TEXT primary key, last_access TEXT)');
db.run('CREATE TABLE IF NOT EXISTS snoozed(cf_handle TEXT primary key, problemId TEXT, snooze_date TEXT)');
db.run('CREATE TABLE IF NOT EXISTS skipped(cf_handle TEXT primary key, problemId TEXT)');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
  res.setHeader('Access-Control-Allow-Credentials', true);
  next();
});

let problemData = {};
let tagSlabs = [[], [], [], [], [], []]; // <1200, <1600, <1900, <2100, <2400, >2399

function dbAllWait(_db, query) {
  return new Promise((resolve, reject) => {
    _db.all(query, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

function checkCFdown() {
  // eslint-disable-next-line no-unused-vars
  request('https://codeforces.com/api/user.info?handles=MikeMirzayanov', (err, res, body) => {
    try {
      isCFdown = JSON.parse(res.body).status !== 'OK';
    } catch (error) {
      isCFdown = true;
    }
  });
}

function getCFData() {
  if (isCFdown) {
    console.log('Codeforces server is not working. Try later...', new Date());
    return;
  }

  // eslint-disable-next-line no-unused-vars
  request('https://codeforces.com/api/problemset.problems', (error, response, body) => {
    try {
      const data = (JSON.parse(response.body)).result;
      problemData = {};
      tagSlabs = [[], [], [], [], [], []];
      data.problems.filter((problem) => problem.index >= 'A').forEach((problem) => {
        const pid = problem.contestId + problem.index;
        problemData[pid] = {
          name: problem.name,
          tags: problem.tags,
          contestId: problem.contestId,
          index: problem.index,
          rating: problem.rating || 0,
        };
        const { rating } = problemData[pid];
        if (rating === -1) return;
        let slabIndex = -1;
        if (rating >= 2400) slabIndex = 5;
        else if (rating >= 2100) slabIndex = 4;
        else if (rating >= 1900) slabIndex = 3;
        else if (rating >= 1600) slabIndex = 2;
        else if (rating >= 1200) slabIndex = 1;
        else slabIndex = 0;

        problem.tags.forEach((tag) => {
          let tagFound = 0;

          tagSlabs[slabIndex].forEach((_tag, idx) => {
            if (_tag.name === tag) {
              // eslint-disable-next-line no-plusplus
              ++tagSlabs[slabIndex][idx].count;
              tagFound = 1;
            }
          });

          if (!tagFound) {
            tagSlabs[slabIndex].push({
              name: tag,
              count: 1,
            });
          }
        });
      });

      data.problemStatistics.forEach((problem) => {
        const pid = problem.contestId + problem.index;
        if (problemData[pid] === undefined) return;
        problemData[pid].solvedBy = problem.solvedCount || 0;
      });

      tagSlabs.forEach((ts) => ts.sort((a, b) => a.count - b.count));
      console.log('Problemset parsed successfully: ', new Date());
    } catch (err) {
      console.log('Error occurred while parse the problemset!');
      setTimeout(getCFData, 10 * 1000);
    }
  });
}

function userSlab(userRating) {
  let userSlabIndex = 0;
  if (userRating >= 2400) userSlabIndex = 5;
  else if (userRating >= 2100) userSlabIndex = 4;
  else if (userRating >= 1900) userSlabIndex = 3;
  else if (userRating >= 1600) userSlabIndex = 2;
  else if (userRating >= 1200) userSlabIndex = 1;
  else userSlabIndex = 0;
  return userSlabIndex;
}

function processRequest(handle, counts, response, low, high) {
  let userSlabIndex = -1;
  let userRating = 0;
  let newUser = false;
  let lastContest = 0;
  let solvability = 10000;
  const returnObject = {};

  const AC = new Set();
  const snoozed = new Set();
  const touched = new Set();

  const getSuggestion = () => {
    const easy = [];
    const medium = [];
    const hard = [];
    const upsolve = [];
    const past = { easy: [], medium: [], hard: [] };
    let subMax = 0;

    userRating = Math.floor(userRating / 100) * 100;
    // eslint-disable-next-line no-param-reassign
    low = low === undefined ? userRating - 200 : low;
    // eslint-disable-next-line no-param-reassign
    high = high === undefined ? userRating + 400 : high;
    returnObject.ratingLow = low;
    returnObject.ratingHigh = high;
    returnObject.problemData = {};

    // eslint-disable-next-line no-restricted-syntax
    for (const problem in problemData) {
      if (problemData[problem].rating < low || problemData[problem].rating > high) {
        // eslint-disable-next-line no-continue
        continue;
      }
      subMax = Math.max(subMax, problemData[problem].solvedBy);
    }

    // eslint-disable-next-line no-restricted-syntax
    for (const problem in problemData) {
      // Collect problems from the last contest
      if (problemData[problem].contestId === lastContest && !(AC.has(problem)) && !(snoozed.has(problem))) {
        upsolve.push({
          contestId : lastContest,
          index : problemData[problem]["index"],
          name : problemData[problem]["name"],
          tags : problemData[problem]["tags"],
          solvedBy : problemData[problem]["solvedBy"],
          solved : false,
          practiceTime : 60
        });

        continue;
      }

      if (problemData[problem]["rating"] < low || problemData[problem]["rating"] > high) continue;

      if (AC.has(problem) || snoozed.has(problem)) continue;

      let score = (100 - (Math.abs(userRating - problemData[problem]["rating"])/userRating))
      let tagScore = 0, tagCount = 0
      problemData[problem]["tags"].forEach(tag => {
        tagScore += tagSlabs[userSlabIndex].findIndex(_tag => _tag.name === tag);
        tagCount++;
      });

      if(tagCount)    score += 200 * tagScore / (tagCount * tagSlabs[userSlabIndex].length);
      score += 300 * problemData[problem]["solvedBy"] / subMax;

      const problemObject = {
        contestId: problemData[problem].contestId,
        index: problemData[problem].index,
        score: Math.floor((score/6)*100)/100,
        name: problemData[problem].name,
        rating: problemData[problem].rating,
        tags: problemData[problem].tags,
        solvedBy: problemData[problem].solvedBy,
        solved: false,
      };

      if(problemData[problem]["rating"] < userRating - 100 && problemData[problem]["solvedBy"] > solvability*2 && problemData[problem]["solvedBy"] < solvability*4){
        problemObject["practiceTime"] = 30
        if(touched.has(problemData[problem]["contestId"]))  past.easy.push(problemObject)
        else easy.push(problemObject)
      } else if(problemData[problem]["rating"] > userRating + 200 && problemData[problem]["solvedBy"] < solvability/2){
        problemObject["practiceTime"] = 60
        if(touched.has(problemData[problem]["contestId"]))  past.hard.push(problemObject)
        else hard.push(problemObject)
      } else if(problemData[problem]["solvedBy"] <= solvability*2  && problemData[problem]["solvedBy"] >= solvability/2 && problemData[problem]["rating"] >= userRating - 100 && problemData[problem]["rating"] <= userRating + 200){
        problemObject["practiceTime"] = 45
        if(touched.has(problemData[problem]["contestId"]))  past.medium.push(problemObject)
        else medium.push(problemObject)
      }
    }
    returnObject.problemData.easy = easy.sort((a, b) => b.score - a.score)
        .slice(0, Math.min(Math.max(0, counts.easy), easy.length));
    returnObject.problemData.medium = medium.sort((a, b) => b.score - a.score)
        .slice(0, Math.min(Math.max(0, counts.medium), medium.length));
    returnObject.problemData.hard = hard.sort((a, b) => b.score - a.score)
        .slice(0, Math.min(Math.max(0, counts.hard), hard.length));
    returnObject.problemData.upsolve = upsolve.sort((a, b) => a.solvedBy < b.solvedBy);
    returnObject.problemData.past = {};
    for(let key in past) {
      returnObject.problemData.past[key] = past[key].sort((a, b) => b.score - a.score).slice(0, Math.min(past[key].length, 3))
    }
    response.json(returnObject)
  }

  const getUserData = () => {
    // eslint-disable-next-line no-unused-vars
    request(`https://codeforces.com/api/user.info?handles=${handle}`, (error, res, body) => {
      const data = JSON.parse(res.body);

      if (data["status"] !== "OK") {
        response.json({"errorMessage": `User ${handle} is not exists.`});
        return;
      }

      db.all(`SELECT * FROM user WHERE cf_handle='${handle}'`, (err, rows) => {
        if (rows === undefined || rows.length === 0) {
          newUser = true;
        }
      });

      const user = data["result"][0];
      userRating = user["maxRating"];

      if (userRating === undefined) userRating = 1000;
      userSlabIndex = userSlab(userRating);
      returnObject.userHandle = handle
      returnObject.userRating = userRating
      returnObject.userFName = user["firstName"]
      returnObject.userLName = user["lastName"]
      returnObject.userRank = user["rank"]
      returnObject.userPic = user["avatar"]
      returnObject.userOrg = user["organization"]
      getStatus();
    });

    const getStatus = () => {
      // eslint-disable-next-line no-unused-vars
      request(`https://codeforces.com/api/user.status?handle=${handle}`, (error, res, body) => {
        try {
          const data = JSON.parse(res.body);

          if (data["status"] !== "OK") {
            response.json({"errorMessage": `User ${handle} is not exists.`});
            return;
          }

          db.all(`SELECT * FROM skipped WHERE cf_handle='${handle}'`, (err, rows) => {
            rows.forEach((item) => {
              AC.push(item["problemId"]);
            });
          }).all(`SELECT * FROM snoozed WHERE cf_handle='${handle}'`, (err, rows) => {
            rows.forEach((item)=> {
              snoozed.push(item["problemId"]);
            });
          });

          data["result"].forEach((submission) => {
            const pid = submission["problem"]["contestId"] + submission["problem"]["index"];

            if (submission["verdict"] === "OK") {
              // Div 2 C => Div 1 A duplicate problem
              if (problemData[pid] === undefined) {
                return; 
              }

              AC.add(pid);

              solvability += problemData[pid]["solvedBy"] * problemData[pid]["rating"] / 4000;
            }

            touched.add(submission["problem"]["contestId"]);
          });

          if (AC.size !== 0) {
            solvability /= AC.size;
          }

          if (newUser) {
            db.run(`INSERT INTO user VALUES('${handle}', datetime('now'))`);
          }
          else {
            db.run(`UPDATE user SET last_access=datetime('now') WHERE cf_handle='${handle}'`);
          }
        } catch(err) {
          console.log(err);
          response.json({errorMessage: "Some error occurred! Please try again later!"});
        } finally {
          getLast();
        }
      })
    }

    const getLast = () => {
      // eslint-disable-next-line no-unused-vars
      request(`https://codeforces.com/api/user.rating?handle=${handle}`, (err, res, body) => {
        try {
          const data = JSON.parse(res.body);
          if (data["status"] === "OK" && data["result"].length) {
            lastContest = data["result"][data["result"].length - 1]["contestId"];
          }
        } catch(err) {
          console.log(err);
          response.json({errorMessage: "Some error occurred! Please try again later!"})
        } finally {
          getSuggestion();
        }
      });
    }
  }

  getUserData();
}

const verifySubmission = (handle, cid, index, response) => {
  // eslint-disable-next-line no-unused-vars
  request(`https://codeforces.com/api/user.status?handle=${handle}&from=1&count=100`, (err, res, body) => {
    const data = JSON.parse(res.body);

    if (data["status"] !== "OK") {
      response.json({"errorMessage": "Some error occurred. Please try again!"});
      return;
    }

    let found = false
    data["result"].forEach((submission) => {
      if (submission["problem"]["contestId"] === cid && submission["problem"]["index"] === index && submission["verdict"] === "OK") {
        found = true;
      }
    });

    response.json({verified : found});
  })
}

const skipQuestion = (handle, pid, response) => {
  try {
    db.run(`INSERT INTO skipped VALUES('${handle}', '${pid}')`);
  } catch(err) {
    response.json({errorMessage: "Some error occurred! Please try again later!"});
  }
}

const getIndex = (usidx, tag) => {
  var index = 0;
  tagSlabs[usidx].forEach((_tag, idx) => {
    if(_tag.name === tag) {
      index = idx + 1;
    }
  })
  return index;
}

function wakeUpSnoozingProblems() {
  db.run("DELETE FROM snoozed WHERE strftime('%s', 'now') - strftime('%s', snooze_date) > 172800", (err) => {
    if (err) {
      console.warn("Error occurred while wake up snoozing problems");
    }
  });
}

function cleanUpForgottenUsers() {
  db.run("DELETE FROM skipped WHERE cf_handle in (SELECT cf_handle FROM user WHERE strftime('%s', 'now') - strftime('%s', last_access)) > 15 * 24 * 3600", (err) => {
    if (err) {
      console.error("Failed to clean skipped problems");
    }
  }).run("DELETE FROM user WHERE strftime('%s', 'now') - strftime('%s', last_access) > 15 * 24 * 3600", (err) => {
    if (err) {
      console.error("Failed to clean fogotten useres");
    }
  });
}

/* HTTP GET */

// eslint-disable-next-line no-shadow
app.get('/suggest/:handle/:easy/:medium/:hard/:low?/:high?', (request, response) => {
  if (isCFdown) {
    response.json({ errorMessage: 'Codeforces seems to be down at the moment!' });
    return response.end();
  }
  const { handle } = request.params;
  const counts = {
    easy: Number(request.params.easy),
    medium: Number(request.params.medium),
    hard: Number(request.params.hard),
  };

  setTimeout(() => {
    processRequest(handle, counts, response, request.params.low, request.params.high);
  }, 100 * (Object.keys(problemData).length === 0));
});

// eslint-disable-next-line no-shadow
app.get('/verify/:handle/:contestId/:index', (request, response) => {
  if (isCFdown) {
    response.json({errorMessage: 'Codeforces seems to be down at the moment!' });
    return response.end();
  }
  const { handle } = request.params;
  const cid = Number(request.params.contestId);
  const { index } = request.params;
  verifySubmission(handle, cid, index, response);
});

// eslint-disable-next-line no-shadow
app.get('/skip/:handle/:pid', (request, response) => {
  skipQuestion(request.params.handle, request.params.pid, response);
});

// eslint-disable-next-line no-shadow
app.get('/later/:handle/:pid', (request, response) => {
  try {
    const snoozeHandle = request.params.handle;
    const problemId = request.params.pid;
    db.run(`INSERT INTO snoozed VALUES('${snoozeHandle}', '${problemId}', datetime('now'))`);
  } catch (err) {
    response.json({errorMessage: 'Some error occurred! Please try again later!'});
  }
});

// eslint-disable-next-line consistent-return
app.get('/swot/:handle', (req, response) => {
  if (isCFdown) {
    response.json({errorMessage: 'Codeforces seems to be down at the moment!'});
    return response.end();
  }

  const { handle } = req.params;
  let usidx = 0;
  const returnObject = {};

  // eslint-disable-next-line no-unused-vars
  request(`https://codeforces.com/api/user.info?handles=${handle}`, (err, res, body) => {
    try {
      const data = JSON.parse(res.body);
      if (data.status !== 'OK') {
        response.json({ errorMessage: 'Invalid User Handle' });
        return;
      }

      const user = data.result[0];
      returnObject.userRating = user.maxRating;
      returnObject.userHandle = user.handle;
      usidx = userSlab(user.maxRating);
    } catch (e) {
      response.json({ errorMessage: 'Some Error occurred! Please try again later.' });
    } finally {
      proceed()
    }
  });

  const proceed = () => {
    // eslint-disable-next-line no-unused-vars
    request(`https://codeforces.com/api/user.status?handle=${handle}`, (err, res, body) => {
      try {
        const data = JSON.parse(res.body);
        const tagMap = new Map();
        const countMap = new Map();

        data.result.forEach((submission) => {
          if (submission.verdict === 'SKIPPED') {
            return;
          }

          const pid = submission.problem.contestId + submission.problem.index;

          if (problemData[pid] === undefined) {
            return;
          }

          submission.problem.tags.forEach((_tag) => {
            let cv = 0;
            let cc = 0;
            if (tagMap.has(_tag)) {
              cv = tagMap.get(_tag);
              cc = countMap.get(_tag);
            }

            let score;
            if (submission.verdict === 'OK') {
              score = 1;
            } else {
              score = 0.2;
            }
            score *= problemData[pid].rating;
            score /= problemData[pid].solvedBy;
            score *= problemData[pid].rating;
            score *= getIndex(usidx, _tag);

            tagMap.set(_tag, cv + score);
            countMap.set(_tag, cc + (submission.verdict === 'OK' ? 1 : 0));
          });
        });

        const returnArray = [];
        tagMap.forEach((value, key) => {
          returnArray.push({ tag: key, points: value, count: countMap.get(key) });
        });
        returnArray.sort((a, b) => a.points - b.points);
        response.json({
          ...returnObject,
          swot: returnArray,
          slab: tagSlabs[usidx].filter((tag) => tag.count > 50),
        });
      } catch (e) {
        response.json({ errorMessage: 'Some Error occurred! Please try again later.' });
      } finally {
        dbAllWait(db, `SELECT * FROM user WHERE cf_handle='${handle}'`).then((result) => {
          if (result.length === 0) {
            db.run(`INSERT INTO user VALUES('${handle}', datetime('now'))`);
          }
        });
      }
    });
  };
});

app.listen(PORT, () => {
  console.log('Server is running');
  checkCFdown();
  getCFData();
  setInterval(getCFData, 3600 * 1000);
  setInterval(checkCFdown, 5 * 60 * 1000);
  setInterval(wakeUpSnoozingProblems, 3600 * 1000);
  setInterval(cleanUpForgottenUsers, 15 * 24 * 3600 * 1000);
});
